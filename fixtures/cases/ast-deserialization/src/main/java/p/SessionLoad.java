package p;

public class SessionLoad {
  public Object read(java.io.InputStream in) throws Exception {
    return new java.io.ObjectInputStream(in).readObject();
  }
}
