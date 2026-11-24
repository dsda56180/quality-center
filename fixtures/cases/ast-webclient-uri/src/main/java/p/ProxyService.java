package p;

import org.springframework.web.reactive.function.client.WebClient;

public class ProxyService {
  public Object fetch(WebClient webClient, String target) {
    return webClient.get().uri(target).retrieve();
  }
}
