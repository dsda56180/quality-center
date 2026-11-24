package p;

import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.builders.WebSecurity;

public class SafeSecurityConfig {
  private static final String[] PUBLIC_PATHS = {"/login", "/health", "/public/**"};
  private static final String[] STATIC_PATHS = {"/static/**", "/favicon.ico"};

  protected void configure(HttpSecurity http) throws Exception {
    http.authorizeRequests().antMatchers(PUBLIC_PATHS).permitAll().anyRequest().authenticated();
    http.authorizeRequests().antMatchers("/actuator/**").hasRole("OPS");
  }

  public void configure(WebSecurity web) {
    web.ignoring().antMatchers(STATIC_PATHS);
  }
}
