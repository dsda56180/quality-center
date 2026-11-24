package p;

import java.net.URL;
import javax.servlet.http.HttpServletResponse;
import org.apache.ibatis.annotations.Select;
import org.springframework.web.client.RestTemplate;

public class SafePatterns2 {
  private RestTemplate restTemplate;

  @Select("select * from t_user where id = #{id}")
  public Object find(String id) {
    return null;
  }

  public void fetch(HttpServletResponse response) throws Exception {
    URL url = new URL("https://api.example.com/ping");
    url.openConnection();
    restTemplate.getForObject("https://api.example.com/ping", String.class);
    response.getWriter().write("<h1>hello</h1>");
  }
}
