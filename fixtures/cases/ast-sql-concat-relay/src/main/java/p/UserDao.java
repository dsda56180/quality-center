package p;

import java.sql.Connection;
import java.sql.ResultSet;

public class UserDao {
  public ResultSet find(Connection conn, String name) throws Exception {
    String sql = "select * from users where name = '" + name + "'";
    return conn.createStatement().executeQuery(sql);
  }
}
