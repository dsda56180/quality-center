package p;

import java.sql.DriverManager;

public class Conn {
  public Object open(String host) throws Exception {
    return DriverManager.getConnection("jdbc:mysql://" + host + "/db", "u", "p");
  }
}
