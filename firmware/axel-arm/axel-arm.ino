// Axel arm firmware (Arduino Uno). A dumb, safe joint server: it moves five servos smoothly to the
// angles the bridge asks for, enforces hard limits, and freezes on stop or if the host goes quiet.
// It knows nothing about items or poses. Protocol: docs/contracts.md §2. Design: docs/arm-plan.md §5.
//
// Open in the Arduino IDE (folder name must match the .ino) or compile as in README → Firmware.

#include <Servo.h>
#include <math.h>
#include <string.h>
#include "config.h"

Servo servos[JOINT_COUNT];
bool attached = false;
bool attaching = false;
bool bootReadyPending = true;
bool attachReplyPending = false;
uint8_t nextAttach = 0;
unsigned long lastAttach = 0;

// The angle each joint is being driven to right now. With no feedback, this is also our best guess
// of where the arm is.
float setpoint[JOINT_COUNT];

// The move in progress: from -> target over `moveMs`, eased with smoothstep.
float moveFrom[JOINT_COUNT];
float moveTarget[JOINT_COUNT];
unsigned long moveStart = 0;
unsigned long moveMs = 0;
bool moving = false;

unsigned long lastHostLine = 0;
unsigned long lastTick = 0;

char line[64];
uint8_t lineLength = 0;
bool discardLine = false;

// ---------- output ----------

uint16_t pulseMicros(uint16_t atZero, uint16_t at180, float degrees) {
  // Widen before subtracting: on the Uno uint16_t - uint16_t wraps, which breaks a reversed servo
  // (pulse at 0° above the pulse at 180°). Millidegrees retain sub-degree easing; the largest
  // calibrated product is 2200 * 180000 = 396000000, within a signed 32-bit long.
  const long start = (long)atZero;
  const long span = (long)at180 - start;
  const long millidegrees = (long)(degrees * 1000.0f + 0.5f);
  return (uint16_t)(start + span * millidegrees / 180000L);
}

uint16_t toMicros(uint8_t joint, float degrees) {
  return pulseMicros(US_AT_0[joint], US_AT_180[joint], degrees);
}

void writeSetpoints() {
  if (!attached) return;
  for (uint8_t j = 0; j < JOINT_COUNT; j++) servos[j].writeMicroseconds(toMicros(j, setpoint[j]));
}

// ---------- commands ----------

// Parse without atoi's partial-token acceptance or overflow on the Uno's 16-bit int.
bool parseInteger(const char *token, int &value) {
  if (!token || !*token) return false;
  bool negative = *token == '-';
  if (negative) token++;
  if (!*token) return false;
  int result = 0;
  while (*token) {
    if (*token < '0' || *token > '9' || result > 180) return false;
    result = result * 10 + (*token++ - '0');
  }
  value = negative ? -result : result;
  return true;
}

// M a1 a2 a3 a4 a5 speed   (a "_" leaves that joint alone)
void handleMove(char *args) {
  float target[JOINT_COUNT];
  const char delimiters[] = {' ', '\t', '\0'};
  char *token = strtok(args, delimiters);
  for (uint8_t j = 0; j < JOINT_COUNT; j++) {
    if (token && token[0] == '_' && token[1] == '\0') {
      target[j] = setpoint[j];
    } else {
      int value;
      if (!parseInteger(token, value)) {
        Serial.println(F("ERR parse"));
        return;
      }
      target[j] = value;
    }
    token = strtok(nullptr, delimiters);
  }
  int speed;
  if (!parseInteger(token, speed) || speed < 1 || speed > 180 || strtok(nullptr, delimiters)) {
    Serial.println(F("ERR parse"));
    return;
  }
  // Validate the entire line before replacing even one joint's target.
  for (uint8_t j = 0; j < JOINT_COUNT; j++) {
    if (target[j] < MIN_DEG[j] || target[j] > MAX_DEG[j]) {
      Serial.print(F("ERR limit "));
      Serial.println(j + 1);
      return;
    }
  }
  if (!attached) {
    Serial.println(F("ERR detached"));
    return;
  }
  float farthest = 0;
  for (uint8_t j = 0; j < JOINT_COUNT; j++) {
    moveFrom[j] = setpoint[j];
    moveTarget[j] = target[j];
    float distance = fabs(target[j] - setpoint[j]);
    if (distance > farthest) farthest = distance;
  }
  // Smoothstep's maximum slope is 1.5. Round up so quantization cannot exceed peak speed.
  moveMs = (unsigned long)ceil(1500.0 * farthest / speed);
  moveStart = millis();
  moving = moveMs > 0;
  Serial.println(F("OK"));
  if (!moving) Serial.println(F("DONE"));
}

void handleStop(const __FlashStringHelper *reason) {
  // Freezing means: keep the current setpoint, drop the target.
  moving = false;
  // Stop also prevents any remaining servo from starting during staggered attachment.
  attaching = false;
  attachReplyPending = false;
  if (reason) {
    Serial.print(F("STOPPED "));
    Serial.println(reason);
  } else {
    Serial.println(F("STOPPED"));
  }
}

void reportPosition() {
  Serial.print(F("POS"));
  for (uint8_t j = 0; j < JOINT_COUNT; j++) {
    Serial.print(' ');
    Serial.print((int)round(setpoint[j]));
  }
  Serial.println();
}

void reportLimits() {
  Serial.print(F("LIM"));
  for (uint8_t j = 0; j < JOINT_COUNT; j++) {
    Serial.print(' ');
    Serial.print(MIN_DEG[j]);
    Serial.print(' ');
    Serial.print(MAX_DEG[j]);
  }
  Serial.println();
}

void attachAll() {
  if (attaching) return;
  if (attached) {
    Serial.println(F("OK"));
    return;
  }
  nextAttach = 0;
  attaching = true;
  // Let loop() attach the first missing servo immediately, including after millis() wraps.
  lastAttach = millis() - ATTACH_GAP_MS;
}

void tickAttach() {
  if (!attaching || millis() - lastAttach < ATTACH_GAP_MS) return;
  while (nextAttach < JOINT_COUNT && servos[ATTACH_ORDER[nextAttach]].attached()) nextAttach++;
  if (nextAttach < JOINT_COUNT) {
    uint8_t j = ATTACH_ORDER[nextAttach++];
    // Configure the range and pulse before Timer1 can emit Servo's default first pulse.
    noInterrupts();
    servos[j].attach(PINS[j], 400, 2600);
    servos[j].writeMicroseconds(toMicros(j, setpoint[j]));
    interrupts();
    lastAttach = millis();
  }
  if (nextAttach == JOINT_COUNT) {
    attaching = false;
    attached = true;
    if (bootReadyPending) {
      Serial.print(F("READY "));
      Serial.println(F(FIRMWARE_VERSION));
      bootReadyPending = false;
    }
    if (attachReplyPending) Serial.println(F("OK"));
    attachReplyPending = false;
  }
}

void detachAll() {
  moving = false;
  attaching = false;
  attachReplyPending = false;
  for (uint8_t j = 0; j < JOINT_COUNT; j++) servos[j].detach();
  attached = false;
}

void handleLine(char *text) {
  if ((text[0] == 'M' && text[1] != ' ' && text[1] != '\t') ||
      (text[0] != 'M' && text[1] != '\0')) {
    Serial.println(F("ERR parse"));
    return;
  }
  switch (text[0]) {
    case 'M': handleMove(text + 1); break;
    case 'S': handleStop(nullptr); break;
    case 'P': reportPosition(); break;
    case 'L': reportLimits(); break;
    case 'H': break;  // heartbeat: only resets the watchdog
    case 'A': attachReplyPending = !attached; attachAll(); break;
    case 'D': detachAll(); Serial.println(F("OK")); break;
    default: Serial.println(F("ERR parse"));
  }
}

void readSerial() {
  // Bound each pass so a continuous input flood cannot starve motion or the watchdog.
  uint8_t budget = sizeof(line);
  while (budget-- && Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      lastHostLine = millis();
      if (discardLine) {
        Serial.println(F("ERR parse"));
      } else {
        // Accept CRLF, but never silently join tokens separated by an embedded CR.
        if (lineLength && line[lineLength - 1] == '\r') lineLength--;
        line[lineLength] = '\0';
        if (lineLength) handleLine(line);
        else Serial.println(F("ERR parse"));
      }
      lineLength = 0;
      discardLine = false;
    } else if (!discardLine) {
      if (c == '\0' || lineLength >= sizeof(line) - 1) {
        // Discard through the delimiter; a valid-looking suffix must never run.
        discardLine = true;
      } else {
        line[lineLength++] = c;
      }
    }
  }
}

// ---------- motion ----------

void tick() {
  if (!moving) return;
  unsigned long elapsed = millis() - moveStart;
  float k = elapsed >= moveMs ? 1.0 : (float)elapsed / moveMs;
  float e = k * k * (3.0 - 2.0 * k);
  for (uint8_t j = 0; j < JOINT_COUNT; j++)
    setpoint[j] = moveFrom[j] + (moveTarget[j] - moveFrom[j]) * e;
  writeSetpoints();
  if (elapsed >= moveMs) {
    moving = false;
    Serial.println(F("DONE"));
  }
}

void watchdog() {
  if (moving && millis() - lastHostLine >= WATCHDOG_MS) handleStop(F("watchdog"));
}

// ---------- main ----------

void setup() {
  Serial.begin(BAUD);
  for (uint8_t j = 0; j < JOINT_COUNT; j++) setpoint[j] = STOW[j];
  attachAll();
}

void loop() {
  watchdog();
  readSerial();
  watchdog();
  tickAttach();
  unsigned long now = millis();
  if (now - lastTick >= TICK_MS) {
    lastTick = now;
    tick();
  }
}
