package p;

import java.sql.Connection;
import org.springframework.web.reactive.function.client.WebClient;

public class SafePatterns3 {
  public void run(Connection conn, WebClient webClient) throws Exception {
    String sql = "select * from users where name = ?";
    conn.createStatement().executeQuery(sql);
    new ProcessBuilder("git", "status").start();
    webClient.get().uri("https://api.example.com/ping").retrieve();
  }
}
