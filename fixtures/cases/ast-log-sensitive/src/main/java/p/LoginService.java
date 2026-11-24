package p;

public class LoginService {
  private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(LoginService.class);

  public void login(String password, String token) {
    log.debug("login with password = {}", password);
    log.info("access token: {}", token);
    log.info("login user {}", "admin");
  }
}
