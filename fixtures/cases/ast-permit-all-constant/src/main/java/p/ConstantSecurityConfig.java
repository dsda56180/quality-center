package p;

import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.WebSecurityConfigurerAdapter;

public class ConstantSecurityConfig extends WebSecurityConfigurerAdapter {
  private static final String[] WHITELIST = {"/actuator/**", "/druid/**"};

  @Override
  protected void configure(HttpSecurity http) throws Exception {
    http.authorizeRequests().antMatchers(WHITELIST).permitAll().anyRequest().authenticated();
  }
}
