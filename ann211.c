#include <stdio.h>
#include <math.h>
#include <stdlib.h>

typedef struct
{
	float w13;		//ann输入层in1到隐含层s3的权重
	float w14;		//ann输入层in1到隐含层s4的权重
	float w23;		//ann输入层in2到隐含层s3的权重
	float w24;		//ann输入层in2到隐含层s4的权重
	float w35;		//ann隐含层s3到输出层s5的权重
	float w45;		//ann隐含层s4到输出层s5的权重
	float theta3;	//s3的阀值
	float theta4;	//s4的阀值
	float theta5;	//s5的阀值
} ANN211PARAMETER;	//ANN参数表类型

//S函数；
float sigmoid(float x);
//初始化ANN；	输入：参数表源地址;
void init_ann211(ANN211PARAMETER* parameter);
//计算ANN输出；	输入：in1，in2，参数表，输出标号;
float ann211(float in1, float in2, ANN211PARAMETER parameter, int n);
//训练ANN；		输入：训练集in1，训练集in2，训练集out，训练集样本数，学习速度（小于1），参数表源地址;
int training_ann211(float in1[], float in2[], float out[], int num, float alfa, ANN211PARAMETER* parameter);

#define SAMPLESIZE 4			//样本数
float ex_in1[SAMPLESIZE] = {0,1,0,1};	//训练样本
float ex_in2[SAMPLESIZE] = {0,0,1,1};
float ex_out[SAMPLESIZE] = {0,0,0,1};

int main(void)
{
	ANN211PARAMETER p;			//ANN参数表
	float in1, in2, out, alfa;	//ANN输入输出

	init_ann211(&p);	//初始化参数表

	printf("\n输入alfa：");
	scanf("%f", &alfa);
	if(!((alfa > 0) && (alfa < 1)))
		alfa = 0.5;

	if(training_ann211(ex_in1, ex_in2, ex_out, SAMPLESIZE, alfa, &p))	//训练ANN
	{
		return 0;
	}

	while(1)
	{
		printf("\nANN输入in1： ");
		scanf("%f", &in1);

		printf("ANN输入in2： ");
		scanf("%f", &in2);

		out = ann211(in1, in2, p, 5);
		printf("ANN输出： %g\n\n", out);
	}

	return 0;
}

void init_ann211(ANN211PARAMETER* parameter)	//初始化ANN
{
	srand((int)time(NULL));

	parameter->w13 = ((rand() % 2) ? 1 : -1) * 1.2 / (rand() % 10 + 1);
	parameter->w14 = ((rand() % 2) ? 1 : -1) * 1.2 / (rand() % 10 + 1); 
	parameter->w23 = ((rand() % 2) ? 1 : -1) * 1.2 / (rand() % 10 + 1); 
	parameter->w24 = ((rand() % 2) ? 1 : -1) * 1.2 / (rand() % 10 + 1);
	parameter->w35 = ((rand() % 2) ? 1 : -1) * 1.2 / (rand() % 10 + 1);
	parameter->w45 = ((rand() % 2) ? 1 : -1) * 1.2 / (rand() % 10 + 1);
	parameter->theta3 = ((rand() % 2) ? 1 : -1) * 1.2 / (rand() % 10 + 1); 
	parameter->theta4 = ((rand() % 2) ? 1 : -1) * 1.2 / (rand() % 10 + 1); 
	parameter->theta5 = ((rand() % 2) ? 1 : -1) * 1.2 / (rand() % 10 + 1); 
}

float ann211(float in1, float in2, ANN211PARAMETER parameter, int n)	//ANN运算
{
	float input3 = 0, input4 = 0, input5 = 0, y3 = 0, y4 = 0, y5 = 0;

	input3 = in1 * parameter.w13 + in2 * parameter.w23 - parameter.theta3;
	input4 = in1 * parameter.w14 + in2 * parameter.w24 - parameter.theta4;
	y3 = sigmoid(input3);
	y4 = sigmoid(input4);
	input5 = y3 * parameter.w35 + y4 * parameter.w45 - parameter.theta5;
	y5 = sigmoid(input5);
	if(n == 3)
		return y3;
	else if(n == 4)
		return y4;
	else
		return y5;
}

float sigmoid(float x)
{
	return (1 / (1 + exp(-1 * x)));
	//return (2 * 1.716 / (1 + exp(-0.667 * x)) - 1.716);
}

int training_ann211(float in1[], float in2[], float out[], int num, float alfa, ANN211PARAMETER* parameter)	//ANN训练
{
	float error = 0, sum = 0;
	float delta5 = 0, deltaw35 = 0, deltaw45 = 0, deltatheta5 = 0, y5 = 0;
	float delta3 = 0, deltaw13 = 0, deltaw23 = 0, deltatheta3 = 0, y3 = 0;
	float delta4 = 0, deltaw14 = 0, deltaw24 = 0, deltatheta4 = 0, y4 = 0;
	int i = 0;
	long j = 0;

	printf("\nANN训练前参数：\n");
	printf("w13: %g, w23: %g, w14: %g, w24: %g, w35: %g, w45: %g, theta3: %g, theta4: %g, theta5: %g\n", \
	       parameter->w13, parameter->w23, parameter->w14, parameter->w24, parameter->w35, parameter->w45, \
	       parameter->theta3, parameter->theta4, parameter->theta5);
	getchar();getchar();

	while(j < 100000)
	{
		for(i = 0, sum = 0; i < num; i++)
		{
			y5 = ann211(in1[i], in2[i], *parameter, 5);
			y3 = ann211(in1[i], in2[i], *parameter, 3);
			y4 = ann211(in1[i], in2[i], *parameter, 4);
			error = out[i] - y5;
			sum += error * error;

			delta5 = y5 * (1 - y5) * error;
			deltaw35 = alfa * y3 * delta5;
			deltaw45 = alfa * y4 * delta5;
			deltatheta5 = alfa * (-1) * delta5;
			
			delta3 = y3 * (1 - y3) * delta5 * parameter->w35;
			deltaw13 = alfa * in1[i] * delta3;
			deltaw23 = alfa * in2[i] * delta3;
			deltatheta3 = alfa * (-1) * delta3;


			delta4 = y4 * (1 - y4) * delta5 * parameter->w45;
			deltaw14 = alfa * in1[i] * delta4;
			deltaw24 = alfa * in2[i] * delta4;
			deltatheta4 = alfa * (-1) * delta4;

			parameter->w35 += deltaw35;
			parameter->w45 += deltaw45;
			parameter->theta5 += deltatheta5;

			parameter->w13 += deltaw13;
			parameter->w23 += deltaw23;
			parameter->theta3 += deltatheta3;

			parameter->w14 += deltaw14;
			parameter->w24 += deltaw24;
			parameter->theta4 += deltatheta4;
		}

		j++;
		printf("第 %lu 次训练后：e: %g\n", j, sum);
		printf("w13: %g, w23: %g, w14: %g, w24: %g, w35: %g, w45: %g, theta3: %g, theta4: %g, theta5: %g\n", \
		       parameter->w13, parameter->w23, parameter->w14, parameter->w24, parameter->w35, parameter->w45, \
		       parameter->theta3, parameter->theta4, parameter->theta5);
		if(sum < 0.001)
			break;
	}

	if(j >= 100000)
	{
		printf("\nANN训练失败。\n\n");
		return 1;
	}

	return 0;
}

