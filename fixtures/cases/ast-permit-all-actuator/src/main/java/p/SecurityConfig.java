package p;

import org.springframework.security.config.annotation.web.builders.HttpSecurity;

public class SecurityConfig {
  protected void configure(HttpSecurity http) throws Exception {
    http.csrf().disable()
        .authorizeRequests()
        .antMatchers("/actuator/**", "/druid/**").permitAll()
        .anyRequest().authenticated();
  }
}
