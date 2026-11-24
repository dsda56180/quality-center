package p;

public class TokenGen {
  public String newToken() {
    return "tok-" + new java.util.Random().nextInt(100000);
  }
}
