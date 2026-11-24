package p;

import javax.servlet.http.HttpServletRequest;

public class AuditLog {
  public void log(HttpServletRequest req, java.util.logging.Logger log) {
    log.info("param=" + req.getParameter("q"));
  }
}
