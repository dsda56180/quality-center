package p;

import org.thymeleaf.TemplateEngine;

public class MailRender {
  public String render(TemplateEngine engine, String tpl) {
    return engine.process(tpl);
  }
}
