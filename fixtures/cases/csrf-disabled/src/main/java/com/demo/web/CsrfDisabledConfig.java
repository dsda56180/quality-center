package com.demo.web;

import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.annotation.web.configuration.WebSecurityConfigurerAdapter;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;

/** 反例：会话 Cookie 的应用关掉 CSRF 保护，任何站点都能替用户提交状态变更请求 */
@Configuration
@EnableWebSecurity
public class CsrfDisabledConfig extends WebSecurityConfigurerAdapter {
    @Override
    protected void configure(HttpSecurity http) throws Exception {
        http.csrf().disable();
        http.authorizeRequests().anyRequest().authenticated();
    }
}
