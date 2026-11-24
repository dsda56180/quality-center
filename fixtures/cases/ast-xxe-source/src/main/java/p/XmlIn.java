package p;

import javax.xml.parsers.DocumentBuilderFactory;

public class XmlIn {
  public Object parse() throws Exception {
    DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
    return factory.newDocumentBuilder().parse("input.xml");
  }
}
