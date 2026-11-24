package p;

import java.io.File;
import org.springframework.web.multipart.MultipartFile;

public class UploadService {
  public void save(MultipartFile file, String baseDir) throws java.io.IOException {
    File target = new File(baseDir, file.getOriginalFilename());
    file.transferTo(target);
  }
}
