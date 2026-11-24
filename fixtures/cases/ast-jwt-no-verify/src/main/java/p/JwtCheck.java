package p;

public class JwtCheck {
  public Object claims(String token) {
    return io.jsonwebtoken.Jwts.parser().parseClaimsJws(token).getBody();
  }
}
