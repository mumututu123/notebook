import os
import requests
from typing import Optional

# 强制让当前 Python 进程走本地代理
os.environ["HTTP_PROXY"] = "http://127.0.0.1:7890"
os.environ["HTTPS_PROXY"] = "http://127.0.0.1:7890"

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import duckdb

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class QueryRequest(BaseModel):
    file_url: str
    file_type: str
    query: Optional[str] = None    # 接收前端传来的自定义 SQL
    keyword: Optional[str] = None  # 接收前端传来的关键字

@app.post("/preview")
def preview_data(req: QueryRequest):
    try:
        con = duckdb.connect(database=':memory:')
        con.execute("INSTALL httpfs; LOAD httpfs;")
        
        # 伪装浏览器，防止被拦截
        con.execute("""
        CREATE SECRET github_auth (
            TYPE HTTP,
            EXTRA_HTTP_HEADERS {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
        );
        """)
        
        print("正在下载文件", req.file_url)
        response = requests.get(req.file_url, allow_redirects=True)
        response.raise_for_status() 
        file_name = "123"
        with open(file_name, 'wb') as f:
            f.write(response.content)
        print("下载完成！")

        # 将文件注册为统一的视图名为 `data`
        if req.file_type == 'parquet':
            con.execute(f"CREATE OR REPLACE VIEW data AS SELECT * FROM read_parquet('{file_name}')")
        elif req.file_type == 'csv':
            con.execute(f"CREATE OR REPLACE VIEW data AS SELECT * FROM read_csv_auto('{file_name}')")
        elif req.file_type == 'json':
            con.execute(f"CREATE OR REPLACE VIEW data AS SELECT * FROM read_json_auto('{file_name}')")
        else:
            raise HTTPException(status_code=400, detail="Unsupported file type")
            
        # 决定要执行的 SQL
        if req.query and req.query.strip():
            # 1. 优先执行用户手写的 SQL
            print(f"执行自定义查询: {req.query}")
            sql_to_run = req.query
            
        elif req.keyword and req.keyword.strip():
            # 2. 如果没有手写 SQL，但传了关键字，则自动生成全列搜索 SQL
            print(f"执行关键字搜索: {req.keyword}")
            # 获取所有列名
            columns_df = con.execute("DESCRIBE data").df()
            columns = columns_df['column_name'].tolist()
            
            # 使用 ILIKE 进行忽略大小写的模糊匹配，将每一列转为 VARCHAR 后匹配
            # 避免 SQL 注入，简单的替换一下单引号
            safe_keyword = req.keyword.replace("'", "''")
            where_clauses = [f"CAST(\"{col}\" AS VARCHAR) ILIKE '%{safe_keyword}%'" for col in columns]
            
            # 组装 SQL，默认限制返回 100 条防止浏览器卡死
            where_sql = " OR ".join(where_clauses)
            sql_to_run = f"SELECT * FROM data WHERE {where_sql} LIMIT 100"
            
        else:
            # 3. 都没有，执行默认预览
            print("执行默认预览查询")
            sql_to_run = "SELECT * FROM data LIMIT 10"

        # 执行最终的 SQL
        df = con.execute(sql_to_run).df()
        
        # 将结果转为 DataFrame 后，全部强制转为字符串
        df = df.astype(str) 
        result = df.to_dict(orient='records')

        return {"status": "success", "data": result}
    except Exception as e:
        print(f"Error: {e}")
        return {"status": "error", "message": str(e)}
