package p;

import java.io.File;
import java.io.FileOutputStream;
import java.util.zip.ZipEntry;

public class Unzip {
  public void extract(ZipEntry entry, String dir) throws java.io.IOException {
    File target = new File(dir, entry.getName());
    new FileOutputStream(target).close();
  }
}
