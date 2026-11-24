package p;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface UserMapper {
  @Select("select * from t_user where name = '${name}'")
  Object findByName(String name);

  @Select("select * from t_user where id = #{id}")
  Object findById(String id);
}
