package p;

import org.springframework.web.multipart.MultipartFile;

public class AvatarUpload {
  public void save(MultipartFile file) {
    if (file.getSize() > 1024 * 1024) {
      throw new IllegalArgumentException("too big");
    }
    String type = file.getContentType();
    if (type == null) {
      throw new IllegalArgumentException("no type");
    }
  }
}
