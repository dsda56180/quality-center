package p;

import javax.servlet.http.HttpServletResponse;

public class EchoServlet {
  public void echo(HttpServletResponse response, String name) throws Exception {
    response.getWriter().write("<h1>hello " + name + "</h1>");
    response.getWriter().println(name);
    response.getWriter().write("<h1>hello</h1>");
  }
}
