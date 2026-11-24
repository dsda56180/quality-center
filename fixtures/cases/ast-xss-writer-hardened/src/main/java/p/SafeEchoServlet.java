package p;

import java.io.PrintWriter;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import org.springframework.web.util.HtmlUtils;

public class SafeEchoServlet extends HttpServlet {
  @Override
  protected void doGet(HttpServletRequest req, HttpServletResponse resp) throws java.io.IOException {
    PrintWriter writer = resp.getWriter();
    writer.println("<h1>hello</h1>");
    writer.write(HtmlUtils.htmlEscape(req.getParameter("q")));
  }
}
