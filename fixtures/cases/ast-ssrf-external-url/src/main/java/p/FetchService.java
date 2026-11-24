package p;

import java.net.URL;
import org.springframework.web.client.RestTemplate;

public class FetchService {
  private RestTemplate restTemplate;

  public void fetch(String target, String cbUrl) throws Exception {
    URL url = new URL(target);
    url.openConnection();
    restTemplate.getForObject(cbUrl, String.class);
    restTemplate.getForObject("https://api.example.com/ping", String.class);
  }
}
