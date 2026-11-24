package p;

public class CommandService {
  public void run(String file) throws Exception {
    Runtime.getRuntime().exec("sh -c " + file);
    new ProcessBuilder("sh", "-c", file).start();
  }

  public void runLiteral() throws Exception {
    Runtime.getRuntime().exec("ls -al");
  }
}
