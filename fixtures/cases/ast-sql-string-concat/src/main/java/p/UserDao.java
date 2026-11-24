package p;

import java.sql.Connection;
import java.sql.Statement;

public class UserDao {
  public void find(Connection conn, String id, String name) throws Exception {
    Statement stmt = conn.createStatement();
    stmt.executeQuery("select * from t_user where id = " + id);
    stmt.executeUpdate("update t_user set name = '" + name + "' where id = ?");
    stmt.executeQuery("select * from t_user");
  }
}
