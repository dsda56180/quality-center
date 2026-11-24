package p;

import java.io.File;
import org.apache.commons.io.FilenameUtils;
import org.springframework.web.multipart.MultipartFile;

public class SafeUploadService {
  public void save(MultipartFile file, String baseDir) throws java.io.IOException {
    String name = FilenameUtils.getName(file.getOriginalFilename());
    file.transferTo(new File(baseDir, name));
  }

  public void saveRelay(MultipartFile file, String baseDir) throws java.io.IOException {
    String name = FilenameUtils.getName(file.getOriginalFilename());
    File target = new File(baseDir, name);
    file.transferTo(target);
  }
}
