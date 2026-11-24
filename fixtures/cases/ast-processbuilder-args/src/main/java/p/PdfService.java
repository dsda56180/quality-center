package p;

public class PdfService {
  public void convert(String input) throws java.io.IOException {
    new ProcessBuilder("wkhtmltopdf", input, "/tmp/out.pdf").start();
  }
}
