package p;

import io.jsonwebtoken.Jwts;
import java.security.MessageDigest;
import java.security.SecureRandom;
import javax.servlet.http.Cookie;
import javax.servlet.http.HttpServletResponse;
import javax.xml.parsers.DocumentBuilderFactory;

public class MiscSafe {
  public Object xxe() throws Exception {
    DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
    factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
    return factory.newDocumentBuilder();
  }

  public String token() {
    return "tok-" + new SecureRandom().nextInt(10);
  }

  public Object claims(String token, javax.crypto.SecretKey key) {
    return Jwts.parser().setSigningKey(key).parseClaimsJws(token);
  }

  public void redirect(HttpServletResponse resp) throws java.io.IOException {
    resp.sendRedirect("/home");
  }

  public void cookie(HttpServletResponse resp, String value) {
    Cookie cookie = new Cookie("pref", value);
    resp.addCookie(cookie);
  }

  public boolean check(String a, String pwd) {
    return MessageDigest.isEqual(a.getBytes(), pwd.getBytes());
  }
}
