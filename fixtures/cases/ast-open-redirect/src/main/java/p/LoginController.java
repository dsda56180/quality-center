package p;

import javax.servlet.http.HttpServletResponse;

public class LoginController {
  public void done(HttpServletResponse resp, String next) throws java.io.IOException {
    resp.sendRedirect(next);
  }
}
