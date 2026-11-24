package p;

import javax.naming.directory.DirContext;

public class LdapLogin {
  public Object find(DirContext ctx, String user) throws Exception {
    return ctx.search("ou=users", "(uid=" + user + ")", null);
  }
}
