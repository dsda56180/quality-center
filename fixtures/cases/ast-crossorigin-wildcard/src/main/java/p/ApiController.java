package p;

import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ApiController {
  @CrossOrigin(origins = "*")
  public String open() {
    return "open";
  }

  @CrossOrigin
  public String bare() {
    return "bare";
  }

  @CrossOrigin(origins = "*", allowCredentials = "true")
  public String withCredentials() {
    return "creds";
  }
}
