package p;

import java.sql.Connection;
import java.sql.ResultSet;

public class SafeReportDao {
  public ResultSet query(Connection conn) throws Exception {
    String sql = String.format("select * from report where name = '%s'", "fixed");
    StringBuilder sb = new StringBuilder();
    sb.append("select * from report order by id");
    return conn.createStatement().executeQuery(sb.toString());
  }
}
