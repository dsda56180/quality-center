package p;

import java.io.FileInputStream;
import javax.servlet.http.HttpServletRequest;

public class Download {
  public Object open(HttpServletRequest req) throws java.io.IOException {
    return new FileInputStream(req.getParameter("path"));
  }
}
