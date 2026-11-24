package p;

import java.io.StringReader;
import java.io.StringWriter;
import javax.servlet.http.HttpServletRequest;
import org.apache.velocity.VelocityContext;
import org.apache.velocity.app.Velocity;
import freemarker.template.Template;

public class ReportRender {
  public void eval(HttpServletRequest req, StringWriter writer, VelocityContext ctx) {
    Velocity.evaluate(ctx, writer, "report", req.getParameter("tpl"));
  }

  public Object build(HttpServletRequest req) throws Exception {
    return new Template("report", new StringReader(req.getParameter("body")));
  }
}
