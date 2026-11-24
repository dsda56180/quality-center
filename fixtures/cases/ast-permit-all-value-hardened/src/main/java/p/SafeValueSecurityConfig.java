package p;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;

public class SafeValueSecurityConfig {
  @Value("${public.base-path:/login}")
  private String publicPath;

  protected void configure(HttpSecurity http) throws Exception {
    http.authorizeRequests().antMatchers(publicPath, "/health").permitAll().anyRequest().authenticated();
  }
}
