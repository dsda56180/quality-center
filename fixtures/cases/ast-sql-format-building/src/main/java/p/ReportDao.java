package p;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;

public class ReportDao {
  public ResultSet query(Connection conn, String name) throws Exception {
    Statement st = conn.createStatement();
    String sql = String.format("select * from report where name = '%s'", name);
    return st.executeQuery(sql);
  }

  public ResultSet querySorted(Connection conn, String orderBy) throws Exception {
    StringBuilder sb = new StringBuilder();
    sb.append("select * from report order by ");
    sb.append(orderBy);
    return conn.createStatement().executeQuery(sb.toString());
  }
}
