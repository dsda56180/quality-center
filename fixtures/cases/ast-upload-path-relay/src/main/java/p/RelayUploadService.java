package p;

import java.io.File;
import org.springframework.web.multipart.MultipartFile;

public class RelayUploadService {
  public void save(MultipartFile file, String baseDir) throws java.io.IOException {
    String name = file.getOriginalFilename();
    File target = new File(baseDir, name);
    file.transferTo(target);
  }
}
