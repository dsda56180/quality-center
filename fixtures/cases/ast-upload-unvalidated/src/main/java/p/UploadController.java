package p;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.multipart.MultipartFile;

public class UploadController {
  @PostMapping("/upload")
  public String upload(@RequestParam("file") MultipartFile file) throws Exception {
    file.transferTo(new java.io.File("/tmp/" + file.getOriginalFilename()));
    return "ok";
  }

  @PostMapping("/upload-safe")
  public String uploadSafe(@RequestParam("file") MultipartFile file) throws Exception {
    if (file.getSize() > 10 * 1024 * 1024) {
      throw new IllegalArgumentException("too large");
    }
    return "ok";
  }
}
