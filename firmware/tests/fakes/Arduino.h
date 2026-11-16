#pragma once
#include <cmath>
#include <cstdint>
#include <deque>
#include <sstream>
#include <string>

struct __FlashStringHelper;
#define F(text) reinterpret_cast<const __FlashStringHelper *>(text)

extern unsigned long testMillis;
inline void noInterrupts() {}
inline void interrupts() {}
inline unsigned long millis() { return testMillis; }

struct FakeSerial {
  std::deque<char> input;
  std::string output;
  void begin(unsigned long) {}
  int available() const { return static_cast<int>(input.size()); }
  char read() { char c = input.front(); input.pop_front(); return c; }
  void print(const __FlashStringHelper *text) { output += reinterpret_cast<const char *>(text); }
  void print(char c) { output += c; }
  template <typename T> void print(T value) { output += std::to_string(value); }
  void println() { output += '\n'; }
  template <typename T> void println(T value) { print(value); println(); }
};
extern FakeSerial Serial;
