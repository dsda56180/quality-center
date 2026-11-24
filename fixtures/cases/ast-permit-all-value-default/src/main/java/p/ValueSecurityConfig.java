package p;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;

public class ValueSecurityConfig {
  @Value("${admin.base-path:/actuator}")
  private String basePath;

  protected void configure(HttpSecurity http) throws Exception {
    http.authorizeRequests().antMatchers(basePath + "/**").permitAll().anyRequest().authenticated();
  }
}
