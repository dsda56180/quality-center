package com.demo.web;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/** 正例：允许凭证但源是显式白名单，不应被判定为宽松 CORS */
@Configuration
public class ExplicitCorsConfig implements WebMvcConfigurer {
    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/api/**")
                .allowedOrigins("https://app.example.com")
                .allowedMethods("GET", "POST")
                .allowCredentials(true)
                .maxAge(3600);
    }
}
