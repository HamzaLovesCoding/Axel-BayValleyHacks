// Host-only regression checks: include the real sketch, replacing only clock, serial and PWM.
#define AXEL_TEST_STOW {90, 120, 30, 90, 90}
#include "fakes/Arduino.h"
#include <cassert>
#include <iostream>
#include "../axel-arm/axel-arm.ino"

unsigned long testMillis = 0;
FakeSerial Serial;

void advance(unsigned long ms) {
  for (unsigned long i = 0; i < ms; i++) { testMillis++; loop(); }
}

std::string send(const std::string &text) {
  Serial.output.clear();
  for (char c : text) Serial.input.push_back(c);
  do { loop(); } while (Serial.available());
  return Serial.output;
}

void boot() {
  testMillis = 0;
  Serial = FakeSerial{};
  for (auto &servo : servos) servo = Servo{};
  attached = attaching = attachReplyPending = moving = discardLine = false;
  bootReadyPending = true;
  nextAttach = lineLength = 0;
  lastHostLine = lastTick = 0;
  setup();
  assert(Serial.output.empty());
  loop();
  assert(servos[3].attached() && !servos[2].attached() && !servos[0].attached());
  assert(send("P\n") == "POS 90 120 30 90 90\n");
  advance(1199);
  assert(!attached && Serial.output.find("READY") == std::string::npos);
  advance(1);
  assert(attached && Serial.output.find("READY 0.1.0\n") != std::string::npos);
  for (uint8_t n = 0; n < JOINT_COUNT; n++) assert(servos[ATTACH_ORDER[n]].attachedAt == n * 300UL);
}

void checkMotionProfiles() {
  const int speeds[] = {1, 7, 25, 30, 60, 180};
  const int targets[][JOINT_COUNT] = {
    {0, 180, 0, 180, 0},
    {180, 0, 180, 0, 180},
    {91, 120, 29, 90, 91},
    {90, 120, 30, 90, 90},
  };
  for (int speed : speeds) for (const auto &target : targets) {
    boot();
    float from[JOINT_COUNT], previous[JOINT_COUNT];
    float farthest = 0;
    std::ostringstream command;
    command << "M";
    for (uint8_t j = 0; j < JOINT_COUNT; j++) {
      from[j] = previous[j] = setpoint[j];
      farthest = fmax(farthest, fabs(target[j] - from[j]));
      command << ' ' << target[j];
    }
    command << ' ' << speed << '\n';
    const unsigned long started = millis();
    send(command.str());
    assert(moveMs == (unsigned long)ceil(1500.0 * farthest / speed));
    while (moving) {
      advance(TICK_MS);
      float progress = -1;
      for (uint8_t j = 0; j < JOINT_COUNT; j++) {
        const float delta = target[j] - from[j];
        // Check actual emitted setpoints: no reversal, overshoot or over-speed step, including
        // the slowest/fastest permitted command and full travel in both directions.
        assert(setpoint[j] >= fmin(from[j], target[j]) - 0.001f);
        assert(setpoint[j] <= fmax(from[j], target[j]) + 0.001f);
        assert(fabs(setpoint[j] - previous[j]) <= speed * TICK_MS / 1000.0f + 0.001f);
        assert(delta >= 0 ? setpoint[j] >= previous[j] : setpoint[j] <= previous[j]);
        assert(servos[j].pulse == toMicros(j, setpoint[j]));
        if (delta) {
          const float fraction = (setpoint[j] - from[j]) / delta;
          if (progress >= 0) assert(fabs(fraction - progress) < 0.001f);
          progress = fraction;
        } else assert(setpoint[j] == from[j]);
        previous[j] = setpoint[j];
      }
      if (moving && (millis() - started) % 200 == 0) send("H\n");
    }
    assert(millis() - started >= moveMs && millis() - started < moveMs + TICK_MS);
    for (uint8_t j = 0; j < JOINT_COUNT; j++) assert(setpoint[j] == target[j]);
    assert(Serial.output.find("DONE\n") != std::string::npos);
  }
}

int main() {
  // Both directions, endpoints, fractional easing and maximum calibration span. No config edits
  // or real PWM are needed to exercise a reversed servo.
  assert(pulseMicros(2500, 500, 0) == 2500);
  assert(pulseMicros(2500, 500, 90) == 1500);
  assert(pulseMicros(2500, 500, 180) == 500);
  assert(pulseMicros(500, 2500, 0) == 500);
  assert(pulseMicros(500, 2500, 90) == 1500);
  assert(pulseMicros(500, 2500, 180) == 2500);
  for (int tenth = 0; tenth <= 1800; tenth++) {
    float angle = tenth / 10.0f;
    const uint16_t forward = pulseMicros(400, 2600, angle);
    const uint16_t reverse = pulseMicros(2600, 400, angle);
    assert(forward >= 400 && forward <= 2600 && reverse >= 400 && reverse <= 2600);
    assert(fabs(forward - (400 + 2200 * angle / 180)) <= 1.01);
    assert(fabs(reverse - (2600 - 2200 * angle / 180)) <= 1.01);
    if (tenth) {
      assert(forward >= pulseMicros(400, 2600, (tenth - 1) / 10.0f));
      assert(reverse <= pulseMicros(2600, 400, (tenth - 1) / 10.0f));
    }
  }
  boot();
  assert(send("L\n") == "LIM 0 180 0 180 0 180 0 180 0 180\n");
  assert(send("M 90 110 40 90 90 60\n") == "OK\n");
  assert(moveMs == 250);
  Serial.output.clear();
  float previous = setpoint[1];
  float maxStep = 0;
  for (int i = 0; i < 260; i++) {
    advance(1);
    float step = fabs(setpoint[1] - previous);
    if (step > maxStep) maxStep = step;
    previous = setpoint[1];
    // Synchronized shoulder and elbow preserve their angle sum.
    assert(fabs(setpoint[1] + setpoint[2] - 150) < 0.001);
  }
  assert(!moving && setpoint[1] == 110 && setpoint[2] == 40);
  assert(Serial.output == "DONE\n" && maxStep <= 1.201);
  assert(send("M _ _ _ _ 100 60\n") == "OK\n");
  advance(260);
  assert(send("P\n") == "POS 90 110 40 90 100\n");

  const std::string bad[] = {
    "M 1 2\n", "M 90 110 40 90 100 60 extra\n", "M 90x 110 40 90 100 60\n",
    "M 90 110 40 90 100 0\n", "M 90 110 40 90 100 181\n",
    "M 90 110 40 90 100 9999999999999\n", "M90 110 40 90 100 60\n",
    "S extra\n", "P extra\n", "L extra\n", "H extra\n", "A extra\n", "D extra\n",
    "S \n", "H\t\n", "\n", "P\rjunk\n",
    std::string(70, 'x') + "M 0 0 0 0 0 60\n",
    std::string("M 0 0") + std::string(1, '\0') + " 0 0 0 60\n"
  };
  for (const auto &text : bad) {
    assert(send(text) == "ERR parse\n");
    assert(!moving && attached);
    assert(send("P\n") == "POS 90 110 40 90 100\n");
  }
  assert(send("M 181 110 40 90 100 60\n") == "ERR limit 1\n");
  assert(send("M 90 -1 40 90 100 60\n") == "ERR limit 2\n");
  assert(send("M _ _ _ _ _ 60\n") == "OK\nDONE\n");
  assert(send("P\r\n") == "POS 90 110 40 90 100\n");

  assert(send("M 120 110 40 90 100 10\n") == "OK\n");
  advance(200);
  float frozen = setpoint[0];
  assert(send("M 90 110 40 90 100 60\n") == "OK\n");
  assert(moveFrom[0] == frozen && setpoint[0] == frozen);
  advance(100);
  assert(!moving && setpoint[0] == 90);
  assert(send("M 120 110 40 90 100 10\n") == "OK\n");
  advance(200);
  assert(send("S\n") == "STOPPED\n");
  frozen = setpoint[0];
  Serial.output.clear();
  advance(1000);
  assert(setpoint[0] == frozen && Serial.output.empty());

  assert(send("M 120 110 40 90 100 10\n") == "OK\n");
  advance(499);
  assert(moving);
  Serial.output.clear();
  advance(1);
  assert(!moving && Serial.output == "STOPPED watchdog\n");
  frozen = setpoint[0];
  advance(200);
  assert(setpoint[0] == frozen);
  assert(send("M 0 110 40 90 100 10\n") == "OK\n");
  advance(200);
  assert(send("M 0 110 40 90 100 10 extra\n") == "ERR parse\n");
  assert(moving && moveTarget[0] == 0);
  advance(499);
  assert(moving);
  advance(1);
  assert(!moving); // Malformed complete lines also count as host activity per contract.

  assert(send("M 120 110 40 90 100 10\n") == "OK\n");
  for (int i = 0; i < 30 && moving; i++) { advance(200); send("H\n"); }
  assert(!moving && setpoint[0] == 120);
  assert(send("D\n") == "OK\n");
  assert(send("M 90 110 40 90 100 60\n") == "ERR detached\n");
  assert(send("A\n").empty());
  advance(100);
  assert(send("S\n") == "STOPPED\n");
  advance(1500);
  assert(!attached && !attaching && servos[3].attached() && !servos[2].attached());
  assert(send("A\n").empty());
  Serial.output.clear();
  advance(900);
  assert(attached && Serial.output == "OK\n");

  boot();
  assert(send("D\n") == "OK\n");
  send("A\n");
  assert(send("D\n") == "OK\n");
  advance(1500);
  for (auto &servo : servos) assert(!servo.attached());

  // Stop during boot cancels further attachments and defers READY until a later A completes.
  attached = attaching = false;
  bootReadyPending = true;
  setup();
  loop();
  assert(send("S\n") == "STOPPED\n");
  Serial.output.clear();
  advance(1500);
  assert(Serial.output.empty() && !attached);
  send("A\n");
  advance(900);
  assert(attached && Serial.output == "READY 0.1.0\nOK\n");
  checkMotionProfiles();
  std::cout << "Firmware regression checks passed (fake clock, serial, servos).\n";
}
