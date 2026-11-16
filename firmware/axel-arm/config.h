#pragma once
#include <Arduino.h>

// Per-joint wiring and limits. Must match bridge/arm.json "joints": the bridge reads these back with
// the L command at connect and refuses to run on any mismatch. Joint order everywhere:
// yaw, shoulder, elbow, wrist, grip.
//
// PLACEHOLDERS until T5 (docs/tasks.md) measures the real values on the arm. Full 0-180 limits mean
// nothing stops the arm from driving into itself yet, so jog slowly.

const uint8_t JOINT_COUNT = 5;

// Uno pins. Any digital pin works with Servo.h. It uses Timer1, so analogWrite() on 9 and 10 stops
// working, which doesn't matter here.
// Matches the builder's wiring: elbow is on 9 and wrist on 6.
const uint8_t PINS[JOINT_COUNT] = {3, 5, 9, 6, 10};

// Pulse width (µs) at 0° and at 180°, from bench-testing each servo (arm-plan §7 step 1).
// 544/2400 is Servo.write()'s mapping, which the builder's full-sweep tests used, so the angles
// they measured mean the same thing here and the power-up pose lands where they expect.
const uint16_t US_AT_0[JOINT_COUNT] = {544, 544, 544, 544, 544};
const uint16_t US_AT_180[JOINT_COUNT] = {2400, 2400, 2400, 2400, 2400};

// Hard limits in servo degrees, a few degrees short of where the arm hits itself (§2.5, §7 step 2).
const uint8_t MIN_DEG[JOINT_COUNT] = {0, 0, 0, 0, 0};
const uint8_t MAX_DEG[JOINT_COUNT] = {180, 180, 180, 180, 180};

// Where the servos are sent at power-up. Keep it equal to bridge/arm.json poses.stow, and always
// stow before cutting power, so the power-up jump is tiny (arm-plan §4).
// Builder-chosen start pose (base 90, shoulder 175, wrist 0). Host tests define AXEL_TEST_STOW to keep their
// fixed reference pose independent of the real arm.
#ifdef AXEL_TEST_STOW
const uint8_t STOW[JOINT_COUNT] = AXEL_TEST_STOW;
#else
const uint8_t STOW[JOINT_COUNT] = {90, 175, 60, 0, 100};
#endif

// Each servo jumps to its setpoint when it attaches. Same order as the recovery rule: wrist and
// elbow first, then the shoulder, then yaw, so a low arm lifts before it swings. Grip goes last.
const uint8_t ATTACH_ORDER[JOINT_COUNT] = {3, 2, 1, 0, 4};

#define FIRMWARE_VERSION "0.1.0"
const unsigned long BAUD = 115200;
const unsigned long TICK_MS = 20;        // 50 Hz setpoint updates
const unsigned long WATCHDOG_MS = 500;   // no line from the host for this long during a move: stop
const unsigned long ATTACH_GAP_MS = 300; // stagger servo attach to avoid a current spike
