package p;

import org.springframework.security.config.annotation.web.builders.WebSecurity;

public class IgnoringSecurityConfig {
  public void configure(WebSecurity web) {
    web.ignoring().antMatchers("/admin/**", "/actuator/env");
  }
}
