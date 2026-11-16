#pragma once
#include "Arduino.h"

struct Servo {
  bool enabled = false;
  int pulse = 1500;
  unsigned long attachedAt = 0;
  void attach(uint8_t, int, int) { enabled = true; attachedAt = millis(); }
  bool attached() const { return enabled; }
  void detach() { enabled = false; }
  void writeMicroseconds(int value) { pulse = value; }
};
