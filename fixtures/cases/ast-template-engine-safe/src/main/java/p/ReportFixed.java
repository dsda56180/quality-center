package p;

import java.io.StringReader;
import java.io.StringWriter;
import org.apache.velocity.VelocityContext;
import org.apache.velocity.app.VelocityEngine;
import freemarker.template.Template;

public class ReportFixed {
  private static final String TEMPLATE_TEXT = "Report: $name";

  public void eval(VelocityEngine velocityEngine, StringWriter writer, VelocityContext ctx) {
    velocityEngine.evaluate(ctx, writer, "report", "Report: $name");
  }

  public Object build() throws Exception {
    return new Template("report", new StringReader(TEMPLATE_TEXT));
  }
}
