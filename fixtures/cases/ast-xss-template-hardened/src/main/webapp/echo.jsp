<%@ page contentType="text/html;charset=UTF-8" %>
<html>
<body>
<p><%= org.springframework.web.util.HtmlUtils.htmlEscape(request.getParameter("q")) %></p>
<p><c:out value="${param.q}"/></p>
</body>
</html>
