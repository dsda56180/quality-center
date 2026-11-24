package p;

import java.sql.Connection;
import java.sql.ResultSet;

public class ChainedReportDao {
  public ResultSet query(Connection conn, String orderBy, String name) throws Exception {
    StringBuilder sb = new StringBuilder();
    sb.append("select * from report order by ").append(orderBy);
    ResultSet first = conn.createStatement().executeQuery(sb.toString());
    return conn
        .createStatement()
        .executeQuery(new StringBuilder("select * from report where name = '").append(name).append("'").toString());
  }
}
