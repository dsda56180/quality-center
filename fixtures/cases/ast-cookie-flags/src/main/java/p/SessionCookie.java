package p;

import javax.servlet.http.Cookie;
import javax.servlet.http.HttpServletResponse;

public class SessionCookie {
  public void set(HttpServletResponse resp, String token) {
    Cookie cookie = new Cookie("JSESSIONID", token);
    resp.addCookie(cookie);
  }
}
