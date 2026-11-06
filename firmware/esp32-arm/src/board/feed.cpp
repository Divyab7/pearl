#ifdef PEARL_DEVICE
#include "feed.h"
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <vector>

namespace feed {

static std::vector<NetworkClient> clients;
static SemaphoreHandle_t lock;
static uint32_t lastTelMs = 0;

void begin() { lock = xSemaphoreCreateMutex(); }

void addClient(NetworkClient& c) {
  c.setNoDelay(true);
  c.print("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\nAccess-Control-Allow-Origin: *\r\n\r\n: hello\n\n");
  xSemaphoreTake(lock, portMAX_DELAY);
  if (clients.size() >= 4) {
    clients.front().stop();
    clients.erase(clients.begin());
  }
  clients.push_back(c);
  xSemaphoreGive(lock);
}

void send(const char* event, const std::string& data) {
  if (!lock) return;
  std::string frame = std::string("event: ") + event + "\ndata: " + data + "\n\n";
  xSemaphoreTake(lock, portMAX_DELAY);
  for (size_t i = 0; i < clients.size();) {
    NetworkClient& c = clients[i];
    if (!c.connected() || c.write(reinterpret_cast<const uint8_t*>(frame.data()), frame.size()) != frame.size()) {
      c.stop();
      clients.erase(clients.begin() + static_cast<long>(i));
    } else {
      i++;
    }
  }
  xSemaphoreGive(lock);
}

void fromArm(const char* line, size_t n, bool tel) {
  if (tel) {
    uint32_t now = millis();
    if (now - lastTelMs < 100) return;
    lastTelMs = now;
    send("tel", std::string(line, n));
  } else {
    send("device", std::string(line, n));
  }
}

}  // namespace feed
#endif
