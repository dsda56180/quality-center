package p;

import java.sql.Connection;
import java.sql.PreparedStatement;
import org.springframework.expression.ExpressionParser;
import org.springframework.web.bind.annotation.CrossOrigin;

public class HardenedService {
  public void find(Connection conn, String id) throws Exception {
    PreparedStatement ps = conn.prepareStatement("select * from t_user where id = ?");
    ps.setString(1, id);
    ps.executeQuery();
  }

  @CrossOrigin(origins = "https://admin.example.com")
  public String api() {
    return "ok";
  }

  public Object eval(ExpressionParser parser) {
    return parser.parseExpression("#{1 + 1}");
  }

  public void run() throws Exception {
    Runtime.getRuntime().exec("ls -al");
  }
}
