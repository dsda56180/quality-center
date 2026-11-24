package p;

import org.springframework.expression.Expression;
import org.springframework.expression.ExpressionParser;

public class SpelService {
  private ExpressionParser parser;

  public Expression eval(String input) {
    return parser.parseExpression(input);
  }

  public Expression evalStatic() {
    return parser.parseExpression("#{1 + 1}");
  }
}
