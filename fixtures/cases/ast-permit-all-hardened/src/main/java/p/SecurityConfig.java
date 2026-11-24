package p;

import org.springframework.security.config.annotation.web.builders.HttpSecurity;

public class SecurityConfig {
  protected void configure(HttpSecurity http) throws Exception {
    http.authorizeRequests()
        .antMatchers("/login", "/health").permitAll()
        .antMatchers("/actuator/**", "/admin/**").hasRole("ADMIN")
        .anyRequest().authenticated();
  }
}
